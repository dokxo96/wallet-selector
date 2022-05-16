import { AppMetadata, SessionTypes } from "@walletconnect/types";
import {
  WalletModuleFactory,
  WalletBehaviourFactory,
  BridgeWallet,
  Subscription,
  Transaction,
  Account,
  JsonStorageService,
} from "@near-wallet-selector/core";

import WalletConnectClient from "./wallet-connect-client";
import { utils, keyStores } from "near-api-js";

export interface WalletConnectParams {
  projectId: string;
  metadata: AppMetadata;
  relayUrl?: string;
  iconUrl?: string;
  chainId?: string;
}

type WalletConnectExtraOptions = Pick<WalletConnectParams, "chainId"> &
  Required<Pick<WalletConnectParams, "projectId" | "metadata" | "relayUrl">>;

interface WalletConnectState {
  client: WalletConnectClient;
  keystore: keyStores.BrowserLocalStorageKeyStore;
  session: SessionTypes.Settled | null;
  accounts: Array<Account>;
  subscriptions: Array<Subscription>;
}

export const STORAGE_ACCOUNTS = "accounts";

const setupWalletConnectState = async (
  id: string,
  params: WalletConnectExtraOptions,
  storage: JsonStorageService
): Promise<WalletConnectState> => {
  const client = new WalletConnectClient();
  const keystore = new keyStores.BrowserLocalStorageKeyStore(
    window.localStorage,
    `near-wallet-selector:${id}:keystore:`
  );
  const accounts = await storage.getItem<Array<Account>>(STORAGE_ACCOUNTS);
  let session: SessionTypes.Settled | null = null;

  await client.init(params);

  if (client.session.topics.length) {
    session = await client.session.get(client.session.topics[0]);
  }

  return {
    client,
    keystore,
    session,
    accounts: accounts || [],
    subscriptions: [],
  };
};

const WalletConnect: WalletBehaviourFactory<
  BridgeWallet,
  { params: WalletConnectExtraOptions }
> = async ({ id, options, params, emitter, storage, logger }) => {
  const _state = await setupWalletConnectState(id, params, storage);

  const getChainId = () => {
    if (params.chainId) {
      return params.chainId;
    }

    const { networkId } = options.network;

    if (["mainnet", "testnet", "betanet"].includes(networkId)) {
      return `near:${networkId}`;
    }

    throw new Error("Invalid chain id");
  };

  const getAccounts = () => {
    return _state.accounts;
  };

  const cleanup = async () => {
    _state.subscriptions.forEach((subscription) => subscription.remove());

    await _state.keystore.clear();

    _state.subscriptions = [];
    _state.session = null;
    _state.accounts = [];

    storage.removeItem(STORAGE_ACCOUNTS);
  };

  const disconnect = async () => {
    if (_state.session) {
      // TODO: Use all transactions once near_signAndSendTransactions is supported.
      const transactions: Array<Transaction> = [];

      for (let i = 0; i < _state.session.state.accounts.length; i += 1) {
        const accountId = _state.session.state.accounts[i].split(":")[2];
        const keyPair = await _state.keystore.getKey(
          options.network.networkId,
          accountId
        );

        transactions.push({
          signerId: accountId,
          receiverId: accountId,
          actions: [
            {
              type: "DeleteKey",
              params: {
                publicKey: keyPair.getPublicKey().toString(),
              },
            },
          ],
        });
      }

      await _state.client.request({
        timeout: 30 * 1000,
        topic: _state.session.topic,
        chainId: getChainId(),
        request: {
          method: "near_signAndSendTransaction",
          params: transactions[0],
        },
      });

      await _state.client.disconnect({
        topic: _state.session.topic,
        reason: {
          code: 5900,
          message: "User disconnected",
        },
      });
    }

    await cleanup();
  };

  const setupEvents = () => {
    _state.subscriptions.push(
      _state.client.on("pairing_created", (pairing) => {
        logger.log("Pairing Created", pairing);
      })
    );

    _state.subscriptions.push(
      _state.client.on("session_updated", (updatedSession) => {
        logger.log("Session Updated", updatedSession);

        if (updatedSession.topic === _state.session?.topic) {
          _state.session = updatedSession;
          emitter.emit("accountsChanged", { accounts: getAccounts() });
        }
      })
    );

    _state.subscriptions.push(
      _state.client.on("session_deleted", async (deletedSession) => {
        logger.log("Session Deleted", deletedSession);

        if (deletedSession.topic === _state.session?.topic) {
          await disconnect();
        }
      })
    );
  };

  if (_state.session) {
    setupEvents();
  }

  return {
    async connect() {
      const existingAccounts = getAccounts();

      if (existingAccounts.length) {
        return existingAccounts;
      }

      try {
        _state.session = await _state.client.connect({
          metadata: params.metadata,
          timeout: 30 * 1000,
          permissions: {
            blockchain: {
              chains: [getChainId()],
            },
            jsonrpc: {
              methods: [
                "near_signAndSendTransaction",
                "near_signAndSendTransactions",
              ],
            },
          },
        });

        // TODO: Use all transactions once near_signAndSendTransactions is supported.
        const [transaction] = _state.session.state.accounts.map<Transaction>(
          (account) => {
            const accountId = account.split(":")[2];
            // TODO: Store keypair in a key store.
            const keyPair = utils.KeyPair.fromRandom("ed25519");

            _state.keystore.setKey(
              options.network.networkId,
              accountId,
              keyPair
            );

            return {
              signerId: accountId,
              receiverId: accountId,
              actions: [
                {
                  type: "AddKey",
                  params: {
                    publicKey: keyPair.getPublicKey().toString(),
                    accessKey: {
                      permission: {
                        receiverId: options.contractId,
                        methodNames: options.methodNames,
                      },
                    },
                  },
                },
              ],
            };
          }
        );

        await _state.client.request({
          timeout: 30 * 1000,
          topic: _state.session.topic,
          chainId: getChainId(),
          request: {
            method: "near_signAndSendTransaction",
            params: transaction,
          },
        });

        setupEvents();

        const accounts: Array<Account> = [{ accountId: transaction.signerId }];
        await storage.setItem(STORAGE_ACCOUNTS, accounts);
        _state.accounts = accounts;

        return getAccounts();
      } catch (err) {
        await disconnect();

        throw err;
      }
    },

    disconnect,

    async getAccounts() {
      return getAccounts();
    },

    async signAndSendTransaction({
      signerId,
      receiverId = options.contractId,
      actions,
    }) {
      logger.log("WalletConnect:signAndSendTransaction", {
        signerId,
        receiverId,
        actions,
      });

      if (!_state.session) {
        throw new Error("Wallet not connected");
      }

      return _state.client.request({
        timeout: 30 * 1000,
        topic: _state.session.topic,
        chainId: getChainId(),
        request: {
          method: "near_signAndSendTransaction",
          params: {
            signerId,
            receiverId,
            actions,
          },
        },
      });
    },

    async signAndSendTransactions({ transactions }) {
      logger.log("WalletConnect:signAndSendTransactions", { transactions });

      if (!_state.session) {
        throw new Error("Wallet not connected");
      }

      return _state.client.request({
        timeout: 30 * 1000,
        topic: _state.session.topic,
        chainId: getChainId(),
        request: {
          method: "near_signAndSendTransactions",
          params: { transactions },
        },
      });
    },
  };
};

export function setupWalletConnect({
  projectId,
  metadata,
  chainId,
  relayUrl = "wss://relay.walletconnect.com",
  iconUrl = "./assets/wallet-connect-icon.png",
}: WalletConnectParams): WalletModuleFactory<BridgeWallet> {
  return async () => {
    return {
      id: "wallet-connect",
      type: "bridge",
      metadata: {
        name: "WalletConnect",
        description: null,
        iconUrl,
      },
      init: (options) => {
        return WalletConnect({
          ...options,
          params: {
            projectId,
            metadata,
            relayUrl,
            chainId,
          },
        });
      },
    };
  };
}