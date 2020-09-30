import { HdPath, Secp256k1Signature } from "@cosmjs/crypto";
import { fromUtf8 } from "@cosmjs/encoding";
import { makeCosmoshubPath } from "@cosmjs/launchpad";
import { assert } from "@cosmjs/utils";
import Transport from "@ledgerhq/hw-transport";
import CosmosApp, {
  AppInfoResponse,
  PublicKeyResponse,
  SignResponse,
  VersionResponse,
} from "ledger-cosmos-js";
import semver from "semver";

/* eslint-disable @typescript-eslint/naming-convention */
export interface LedgerAppErrorResponse {
  readonly error_message?: string;
  readonly device_locked?: boolean;
}
/* eslint-enable */

interface ConnectedApp {
  /** The transport used by the app */
  readonly transport: Transport;
  readonly app: CosmosApp;
}

/** Time to establish a connection in milliseconds */
const defaultOpenTimeout = 120_000;
const requiredCosmosAppVersion = "1.5.3";

function isWindows(platform: string): boolean {
  return platform.indexOf("Win") > -1;
}

function verifyBrowserIsSupported(platform: string, userAgent: string | null): void {
  if (isWindows(platform)) {
    throw new Error("Windows is not currently supported.");
  }

  const isChromeOrBrave = userAgent && /chrome|crios/i.test(userAgent) && !/edge|opr\//i.test(userAgent);
  if (!isChromeOrBrave) {
    throw new Error("Your browser does not support Ledger devices.");
  }
}

function unharden(hdPath: HdPath): number[] {
  return hdPath.map((n) => (n.isHardened() ? n.toNumber() - 2 ** 31 : n.toNumber()));
}

const cosmosHdPath = makeCosmoshubPath(0);
const cosmosBech32Prefix = "cosmos";

export interface LaunchpadLedgerOptions {
  readonly hdPaths?: readonly HdPath[];
  readonly prefix?: string;
  readonly testModeAllowed?: boolean;
}

export class LaunchpadLedger {
  private readonly testModeAllowed: boolean;
  private readonly hdPaths: readonly HdPath[];
  private readonly prefix: string;
  private connectedApp: ConnectedApp | null;
  public readonly platform: string;
  public readonly userAgent: string | null;

  public constructor(options: LaunchpadLedgerOptions = {}) {
    const defaultOptions = {
      hdPaths: [cosmosHdPath],
      prefix: cosmosBech32Prefix,
      testModeAllowed: false,
    };
    const { hdPaths, prefix, testModeAllowed } = {
      ...defaultOptions,
      ...options,
    };
    this.testModeAllowed = testModeAllowed;
    this.hdPaths = hdPaths;
    this.prefix = prefix;
    this.connectedApp = null;

    try {
      this.platform = navigator.platform;
      this.userAgent = navigator.userAgent;
    } catch (error) {
      this.platform = "node";
      this.userAgent = null;
    }
  }

  public async getCosmosAppVersion(): Promise<string> {
    await this.ensureConnected();
    assert(this.connectedApp, "Cosmos Ledger App is not connected");

    const response = await this.connectedApp.app.getVersion();
    this.handleLedgerErrors(response);
    // eslint-disable-next-line @typescript-eslint/naming-convention
    const { major, minor, patch, test_mode: testMode } = response as VersionResponse;
    this.verifyAppMode(testMode);
    return `${major}.${minor}.${patch}`;
  }

  public async getPubkey(hdPath?: HdPath): Promise<Uint8Array> {
    await this.ensureConnected();
    assert(this.connectedApp, "Cosmos Ledger App is not connected");

    const hdPathToUse = hdPath || this.hdPaths[0];
    // ledger-cosmos-js hardens the first three indices
    const response = await this.connectedApp.app.publicKey(unharden(hdPathToUse));
    this.handleLedgerErrors(response);
    return Uint8Array.from((response as PublicKeyResponse).compressed_pk);
  }

  public async getPubkeys(): Promise<readonly Uint8Array[]> {
    return this.hdPaths.reduce(
      (promise: Promise<readonly Uint8Array[]>, hdPath) =>
        promise.then(async (pubkeys) => [...pubkeys, await this.getPubkey(hdPath)]),
      Promise.resolve([]),
    );
  }

  public async getCosmosAddress(pubkey?: Uint8Array): Promise<string> {
    const pubkeyToUse = pubkey || (await this.getPubkey());
    return CosmosApp.getBech32FromPK(this.prefix, Buffer.from(pubkeyToUse));
  }

  public async sign(message: Uint8Array, hdPath?: HdPath): Promise<Uint8Array> {
    await this.ensureConnected();
    assert(this.connectedApp, "Cosmos Ledger App is not connected");

    const hdPathToUse = hdPath || this.hdPaths[0];
    // ledger-cosmos-js hardens the first three indices
    const response = await this.connectedApp.app.sign(unharden(hdPathToUse), fromUtf8(message));
    this.handleLedgerErrors(response, "Transaction signing request was rejected by the user");
    return Secp256k1Signature.fromDer((response as SignResponse).signature).toFixedLength();
  }

  public async disconnect(): Promise<void> {
    if (this.connectedApp) {
      await this.connectedApp.transport.close();
      this.connectedApp = null;
    }
  }

  private async ensureConnected(): Promise<void> {
    // assume good connection if connected once
    if (this.connectedApp) {
      return;
    }

    if (this.platform !== "node") {
      verifyBrowserIsSupported(this.platform, this.userAgent);
    }

    const transport = await this.createTransport(defaultOpenTimeout);
    this.connectedApp = {
      transport: transport,
      app: new CosmosApp(transport),
    };

    await this.verifyDeviceIsReady();
  }

  /**
   * @param openTimeout The time to establish a connection in milliseconds. This is
   *                    [passed into as the second argument into Transport.open](https://github.com/LedgerHQ/ledgerjs/blob/v5.25.2/packages/hw-transport/src/Transport.js#L235),
   *                    which is ignored by both [TransportWebUSB.open](https://github.com/LedgerHQ/ledgerjs/blob/v5.25.2/packages/hw-transport-webusb/src/TransportWebUSB.js#L116)
   *                    and [TransportNodeHid.open](https://github.com/LedgerHQ/ledgerjs/blob/v5.25.2/packages/hw-transport-node-hid/src/TransportNodeHid.js#L115).
   */
  private async createTransport(openTimeout: number): Promise<Transport> {
    // HACK: Use a variable to get webpack to ignore this
    const transportPackageName =
      this.platform === "node" ? "@ledgerhq/hw-transport-node-hid" : "@ledgerhq/hw-transport-webusb";

    let module: any;
    try {
      module = await import(transportPackageName);
    } catch (e) {
      throw new Error(
        `Error importing module "${transportPackageName}". See https://github.com/CosmWasm/cosmjs/blob/master/packages/launchpad-ledger/README.md for installation instructions.`,
      );
    }

    /* eslint-disable-next-line @typescript-eslint/naming-convention */
    const TransportClass = module.default;

    try {
      const transport = await TransportClass.create(openTimeout);
      return transport;
    } catch (error) {
      const trimmedErrorMessage = error.message.trim();
      if (trimmedErrorMessage.startsWith("No WebUSB interface found for your Ledger device")) {
        throw new Error(
          "Could not connect to a Ledger device. Please use Ledger Live to upgrade the Ledger firmware to version 1.5.5 or later.",
        );
      }
      if (trimmedErrorMessage.startsWith("Unable to claim interface")) {
        throw new Error("Could not access Ledger device. Is it being used in another tab?");
      }
      if (trimmedErrorMessage.startsWith("Not supported")) {
        throw new Error(
          "Your browser does not seem to support WebUSB yet. Try updating it to the latest version.",
        );
      }
      if (trimmedErrorMessage.startsWith("No device selected")) {
        throw new Error(
          "You did not select a Ledger device. If you did not see your Ledger, check if the Ledger is plugged in and unlocked.",
        );
      }

      throw error;
    }
  }

  private verifyAppMode(testMode: boolean): void {
    if (testMode && !this.testModeAllowed) {
      throw new Error(`DANGER: The Cosmos Ledger app is in test mode and should not be used on mainnet!`);
    }
  }

  private async getOpenAppName(): Promise<string> {
    await this.ensureConnected();
    assert(this.connectedApp, "Cosmos Ledger App is not connected");

    const response = await this.connectedApp.app.appInfo();
    this.handleLedgerErrors(response);
    return (response as AppInfoResponse).appName;
  }

  private async verifyAppVersion(): Promise<void> {
    const version = await this.getCosmosAppVersion();
    if (!semver.gte(version, requiredCosmosAppVersion)) {
      throw new Error("Outdated version: Please update Cosmos Ledger App to the latest version.");
    }
  }

  private async verifyCosmosAppIsOpen(): Promise<void> {
    const appName = await this.getOpenAppName();

    if (appName.toLowerCase() === `dashboard`) {
      throw new Error(`Please open the Cosmos Ledger app on your Ledger device.`);
    }
    if (appName.toLowerCase() !== `cosmos`) {
      throw new Error(`Please close ${appName} and open the Cosmos Ledger app on your Ledger device.`);
    }
  }

  private async verifyDeviceIsReady(): Promise<void> {
    await this.verifyAppVersion();
    await this.verifyCosmosAppIsOpen();
  }

  private handleLedgerErrors(
    /* eslint-disable @typescript-eslint/naming-convention */
    {
      error_message: errorMessage = "No errors",
      device_locked: deviceLocked = false,
    }: LedgerAppErrorResponse,
    /* eslint-enable */
    rejectionMessage = "Request was rejected by the user",
  ): void {
    if (deviceLocked) {
      throw new Error("Ledger’s screensaver mode is on");
    }
    switch (errorMessage) {
      case "U2F: Timeout":
        throw new Error("Connection timed out. Please try again.");
      case "Cosmos app does not seem to be open":
        throw new Error("Cosmos app is not open");
      case "Command not allowed":
        throw new Error("Transaction rejected");
      case "Transaction rejected":
        throw new Error(rejectionMessage);
      case "Unknown Status Code: 26628":
        throw new Error("Ledger’s screensaver mode is on");
      case "Instruction not supported":
        throw new Error(
          `Your Cosmos Ledger App is not up to date. Please update to version ${requiredCosmosAppVersion}.`,
        );
      case "No errors":
        break;
      default:
        throw new Error(`Ledger Native Error: ${errorMessage}`);
    }
  }
}
