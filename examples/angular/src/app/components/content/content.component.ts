import { Component, Input, OnDestroy, OnInit } from "@angular/core";
import NearWalletSelector from "@near-wallet-selector/core";
import { AccountInfo } from "@near-wallet-selector/wallet";
import { Subscription } from "@near-wallet-selector/utils";
import { providers, utils } from "near-api-js";
import { Message } from "../../interfaces/message";
import { Sumbitted } from "../form/form.component";
import { AccountView, CodeResult } from "near-api-js/lib/providers/provider";
import { Account } from "../../interfaces/account";

const { parseNearAmount } = utils.format;

const SUGGESTED_DONATION = "0";
const BOATLOAD_OF_GAS = parseNearAmount("0.00000000003");

@Component({
  selector: "near-wallet-selector-content",
  templateUrl: "./content.component.html",
  styleUrls: ["./content.component.scss"],
})
export class ContentComponent implements OnInit, OnDestroy {
  @Input() selector: NearWalletSelector;
  @Input() accounts: Array<AccountInfo>;
  @Input() accountId: string | null;

  account: Account | null;
  messages: Array<Message>;
  subscription?: Subscription;

  async ngOnInit() {
    const [messages, account] = await Promise.all([
      this.getMessages(),
      this.getAccount(),
    ]);

    this.account = account;
    this.messages = messages;

    this.subscribeToEvents();
  }

  async getAccount() {
    if (!this.accountId) {
      return null;
    }

    const { nodeUrl } = this.selector.network;
    const provider = new providers.JsonRpcProvider({ url: nodeUrl });

    return provider
      .query<AccountView>({
        request_type: "view_account",
        finality: "final",
        account_id: this.accountId,
      })
      .then((data) => ({
        ...data,
        account_id: this.accountId,
      }));
  }

  signIn() {
    this.selector.show();
  }

  signOut() {
    this.selector.signOut().catch((err) => {
      console.log("Failed to sign out");
      console.error(err);
    });
  }

  switchProvider() {
    this.selector.show();
  }

  getMessages() {
    const provider = new providers.JsonRpcProvider({
      url: this.selector.network.nodeUrl,
    });

    return provider
      .query<CodeResult>({
        request_type: "call_function",
        account_id: this.selector.getContractId(),
        method_name: "getMessages",
        args_base64: "",
        finality: "optimistic",
      })
      .then((res) => JSON.parse(Buffer.from(res.result).toString()));
  }

  switchAccount() {
    const currentIndex = this.accounts.findIndex(
      (x) => x.accountId === this.accountId
    );
    const nextIndex =
      currentIndex < this.accounts.length - 1 ? currentIndex + 1 : 0;

    const nextAccountId = this.accounts[nextIndex].accountId;

    this.accountId = nextAccountId;
    alert("Switched account to " + nextAccountId);

    this.account = null;
    this.getAccount().then((account) => {
      this.account = account;
    });
  }

  syncAccountState(
    currentAccountId: string | null,
    newAccounts: Array<AccountInfo>
  ) {
    if (!newAccounts.length) {
      localStorage.removeItem("accountId");
      this.accountId = null;
      this.accounts = [];

      return;
    }

    const validAccountId =
      currentAccountId &&
      newAccounts.some((x) => x.accountId === currentAccountId);
    const newAccountId = validAccountId
      ? currentAccountId
      : newAccounts[0].accountId;

    localStorage.setItem("accountId", newAccountId);
    this.accountId = newAccountId;
    this.accounts = newAccounts;
  }

  subscribeToEvents() {
    this.subscription = this.selector.on("accountsChanged", (e) => {
      const prevAccountId = this.accountId;

      this.syncAccountState(this.accountId, e.accounts);

      if (prevAccountId !== this.accountId) {
        this.getAccount().then((account) => {
          this.account = account;
        });
      }
    });
  }

  onSubmit(e: Sumbitted) {
    const { fieldset, message, donation } = e.target.elements;

    fieldset.disabled = true;

    // TODO: optimistically update page with new message,
    // update blockchain data in background
    // add uuid to each message, so we know which one is already known
    this.selector
      .signAndSendTransaction({
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        signerId: this.accountId!,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "addMessage",
              args: { text: message.value },
              gas: BOATLOAD_OF_GAS as string,
              deposit: utils.format.parseNearAmount(
                donation.value || "0"
              ) as string,
            },
          },
        ],
      })
      .catch((err) => {
        alert("Failed to add message");
        console.log("Failed to add message");
        throw err;
      })
      .then(() => {
        return this.getMessages()
          .then((nextMessages) => {
            this.messages = nextMessages;
            message.value = "";
            donation.value = SUGGESTED_DONATION;
            fieldset.disabled = false;
            message.focus();
          })
          .catch((err) => {
            alert("Failed to refresh messages");
            console.log("Failed to refresh messages");
            throw err;
          });
      })
      .catch((err) => {
        console.error(err);

        fieldset.disabled = false;
      });
  }

  ngOnDestroy() {
    this.subscription?.remove();
  }
}