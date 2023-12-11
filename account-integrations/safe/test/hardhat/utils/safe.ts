import { AddressLike, JsonRpcProvider, Provider, Signer, ethers } from "ethers";

// Import from Safe contracts repo once fixed
import {
  MetaTransaction,
  SafeSignature,
  buildSignatureBytes,
} from "./execution";

export type UserOperation = {
  sender: string;
  nonce: string;
  initCode: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymasterAndData: string;
  signature: string;
};

export const EIP712_SAFE_OPERATION_TYPE = {
  SafeOp: [
    { type: "address", name: "safe" },
    { type: "uint256", name: "nonce" },
    { type: "bytes", name: "initCode" },
    { type: "bytes", name: "callData" },
    { type: "uint256", name: "callGasLimit" },
    { type: "uint256", name: "verificationGasLimit" },
    { type: "uint256", name: "preVerificationGas" },
    { type: "uint256", name: "maxFeePerGas" },
    { type: "uint256", name: "maxPriorityFeePerGas" },
    { type: "bytes", name: "paymasterAndData" },
    { type: "uint48", name: "validAfter" },
    { type: "uint48", name: "validUntil" },
    { type: "address", name: "entryPoint" },
  ],
};

// eslint-disable-next-line @typescript-eslint/naming-convention
const AddressOne = "0x0000000000000000000000000000000000000001";

const INTERFACES = new ethers.Interface([
  "function enableModule(address)",
  "function setup(address[],uint256,address,bytes,address,address,uint256,address)",
  "function createProxyWithNonce(address,bytes,uint256) returns (address)",
  "function proxyCreationCode() returns (bytes)",
  "function enableModules(address[])",
  "function execTransactionFromModule(address to, uint256 value, bytes calldata data, uint8 operation) external payable returns (bool success)",
  "function executeUserOp(address to, uint256 value, bytes calldata data, uint8 operation)",
  "function getNonce(address,uint192) returns (uint256 nonce)",
  "function supportedEntryPoint() returns (address)",
  "function getOwners() returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function getModulesPaginated(address, uint256) returns (address[], address)",
  "function getOperationHash(address,bytes,uint256,uint256,uint256,uint256,uint256,uint256,address)",
]);

export type OperationParams = {
  nonce: bigint;
  initCode: string;
  preVerificationGas: bigint;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  paymasterAndData: string;
  validAfter: bigint;
  validUntil: bigint;
};

export type GlobalConfig = {
  safeSingleton: string;
  entryPoint: string;
  erc4337module: string;
  proxyFactory: string;
  proxyCreationCode: string;
  addModulesLib: string;
  chainId: number;
};

export type SafeConfig = {
  signers: string[];
  threshold: number;
  nonce: number;
};

const calculateProxyAddress = (
  globalConfig: GlobalConfig,
  inititalizer: string,
  nonce: number | string,
): string => {
  const deploymentCode = ethers.solidityPacked(
    ["bytes", "uint256"],
    [globalConfig.proxyCreationCode, globalConfig.safeSingleton],
  );
  const salt = ethers.solidityPackedKeccak256(
    ["bytes32", "uint256"],
    [ethers.solidityPackedKeccak256(["bytes"], [inititalizer]), nonce],
  );
  return ethers.getCreate2Address(
    globalConfig.proxyFactory,
    salt,
    ethers.keccak256(deploymentCode),
  );
};

const buildInitParamsForConfig = (
  safeConfig: SafeConfig,
  globalConfig: GlobalConfig,
): { safeAddress: string; initCode: string } => {
  const initData = INTERFACES.encodeFunctionData("enableModules", [
    [globalConfig.erc4337module],
  ]);
  const setupData = INTERFACES.encodeFunctionData("setup", [
    safeConfig.signers,
    safeConfig.threshold,
    globalConfig.addModulesLib,
    initData,
    globalConfig.erc4337module,
    ethers.ZeroAddress,
    0,
    ethers.ZeroAddress,
  ]);
  const deployData = INTERFACES.encodeFunctionData("createProxyWithNonce", [
    globalConfig.safeSingleton,
    setupData,
    safeConfig.nonce,
  ]);
  const safeAddress = calculateProxyAddress(
    globalConfig,
    setupData,
    safeConfig.nonce,
  );
  const initCode = ethers.solidityPacked(
    ["address", "bytes"],
    [globalConfig.proxyFactory, deployData],
  );
  return {
    safeAddress,
    initCode,
  };
};

const callInterface = async (
  provider: Provider,
  contract: string,
  method: string,
  params: unknown[],
): Promise<ethers.Result> => {
  const result = await provider.call({
    to: contract,
    data: INTERFACES.encodeFunctionData(method, params),
  });
  console.log(result);
  return INTERFACES.decodeFunctionResult(method, result);
};

const actionCalldata = (action: MetaTransaction): string => {
  return INTERFACES.encodeFunctionData("executeUserOp", [
    action.to,
    action.value,
    action.data,
    action.operation,
  ]);
};

export type RpcProvider = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send(method: string, params: unknown[]): Promise<any>;
} & Provider;

export class MultiProvider4337 extends JsonRpcProvider {
  generalProvider: RpcProvider;
  constructor(aaProviderUrl: string, generalProvider: RpcProvider) {
    super(aaProviderUrl);
    this.generalProvider = generalProvider;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async send(method: string, params: unknown[]): Promise<any> {
    if (
      [
        "eth_supportedEntryPoints",
        "eth_estimateUserOperationGas",
        "eth_sendUserOperation",
        "eth_getUserOperationByHash",
        "eth_getUserOperationReceipt",
      ].includes(method)
    ) {
      return super.send(method, params);
    } else {
      return this.generalProvider.send(method, params);
    }
  }

  public async sendUserOperation(
    userOp: UserOperation,
    entryPoint: AddressLike,
  ): Promise<string> {
    return await super.send("eth_sendUserOperation", [
      userOp,
      await ethers.resolveAddress(entryPoint, this),
    ]);
  }
}

export class Safe4337Operation {
  private readonly safe: Safe4337;
  private readonly action: MetaTransaction;
  private readonly params: OperationParams;
  private readonly globalConfig: GlobalConfig;
  private readonly signatures: SafeSignature[] = [];

  constructor(
    safe: Safe4337,
    action: MetaTransaction,
    params: OperationParams,
    globalConfig: GlobalConfig,
  ) {
    this.safe = safe;
    this.action = action;
    this.params = params;
    this.globalConfig = globalConfig;
  }

  operationHash(): string {
    return ethers.TypedDataEncoder.hash(
      {
        chainId: this.globalConfig.chainId,
        verifyingContract: this.globalConfig.erc4337module,
      },
      EIP712_SAFE_OPERATION_TYPE,
      {
        safe: this.safe.address,
        callData: actionCalldata(this.action),
        entryPoint: this.globalConfig.entryPoint,
        ...this.params,
      },
    );
  }

  async encodedSignatures(): Promise<string> {
    return buildSignatureBytes(this.signatures);
  }

  async userOperation(paymasterAndData = "0x"): Promise<UserOperation> {
    return {
      nonce: ethers.toBeHex(this.params.nonce),
      callData: actionCalldata(this.action),
      verificationGasLimit: ethers.toBeHex(this.params.verificationGasLimit),
      preVerificationGas: ethers.toBeHex(this.params.preVerificationGas),
      callGasLimit: ethers.toBeHex(this.params.callGasLimit),
      maxFeePerGas: ethers.toBeHex(this.params.maxFeePerGas),
      maxPriorityFeePerGas: ethers.toBeHex(this.params.maxPriorityFeePerGas),
      initCode: this.params.initCode,
      paymasterAndData,
      sender: this.safe.address,
      signature: ethers.solidityPacked(
        ["uint48", "uint48", "bytes"],
        [
          this.params.validAfter,
          this.params.validUntil,
          await this.encodedSignatures(),
        ],
      ),
    };
  }

  async authorize(signer: ethers.Signer) {
    const validSigners = await this.safe.getSigners();
    const signerAddress = await signer.getAddress();
    if (!validSigners.includes(signerAddress)) throw Error("Invalid Signer");
    if (
      this.signatures.findIndex(
        (signature) => signature.signer === signerAddress,
      ) >= 0
    )
      throw Error("Already signed");
    this.signatures.push({
      signer: signerAddress,
      data: await signer.signTypedData(
        {
          chainId: this.globalConfig.chainId,
          verifyingContract: this.globalConfig.erc4337module,
        },
        EIP712_SAFE_OPERATION_TYPE,
        {
          safe: this.safe.address,
          callData: actionCalldata(this.action),
          entryPoint: this.globalConfig.entryPoint,
          ...this.params,
        },
      ),
    });
    console.log(this.signatures);
  }

  static async build(
    provider: RpcProvider,
    safe: Safe4337,
    action: MetaTransaction,
    globalConfig: GlobalConfig,
  ): Promise<Safe4337Operation> {
    const initCode = (await safe.isDeployed()) ? "0x" : safe.getInitCode();
    const nonce = (
      await callInterface(provider, globalConfig.entryPoint, "getNonce", [
        safe.address,
        0,
      ])
    )[0];
    const estimateOperation = {
      sender: safe.address,
      callData: actionCalldata(action),
      paymasterAndData: "0x",
      nonce: ethers.toBeHex(nonce),
      initCode,
      signature: "0x".padEnd(130, "a"),
      // For some providers we need to set some really high values to allow estimation
      preVerificationGas: ethers.toBeHex(1000000),
      verificationGasLimit: ethers.toBeHex(1000000),
      callGasLimit: ethers.toBeHex(10000000),
      // To keep the required funds low, the gas fee is set close to the minimum
      maxFeePerGas: "0x10",
      maxPriorityFeePerGas: "0x10",
    };
    const estimates = await provider.send("eth_estimateUserOperationGas", [
      {
        ...estimateOperation,
      },
      globalConfig.entryPoint,
    ]);
    console.log(estimates);

    const feeData = await provider.getFeeData();

    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas)
      throw Error("Missing fee data");

    const params: OperationParams = {
      nonce,
      initCode,
      maxFeePerGas: feeData.maxFeePerGas,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
      // Add a small margin as some dataoverhead calculation is not always accurate
      preVerificationGas: BigInt(estimates.preVerificationGas) + 1000n,
      // Add 20% to the gas limits to account for inaccurate estimations
      verificationGasLimit:
        (BigInt(estimates.verificationGasLimit) * 12n) / 10n,
      callGasLimit: (BigInt(estimates.callGasLimit) * 12n) / 10n,
      validAfter: 0n,
      validUntil: 0n,
      paymasterAndData: "0x",
    };
    return new Safe4337Operation(safe, action, params, globalConfig);
  }
}

export class Safe4337 {
  public address: string;
  private readonly globalConfig: GlobalConfig;
  private readonly safeConfig: SafeConfig | undefined;
  private provider: RpcProvider | undefined;

  constructor(
    address: string,
    globalConfig: GlobalConfig,
    safeConfig?: SafeConfig,
  ) {
    if (safeConfig) {
      const initParams = buildInitParamsForConfig(safeConfig, globalConfig);
      if (address !== initParams.safeAddress) throw Error("Invalid configs");
    }
    this.address = address;
    this.globalConfig = globalConfig;
    this.safeConfig = safeConfig;
  }

  connect(provider: RpcProvider): this {
    this.provider = provider;
    return this;
  }

  disconnect() {
    this.provider = undefined;
  }

  async isDeployed(): Promise<boolean> {
    if (!this.provider) throw Error("Not connected!");

    const code = await this.provider.getCode(this.address, "latest");
    return code !== "0x";
  }

  async deploy(deployer: Signer): Promise<void> {
    const initCode = this.getInitCode();
    const factory = ethers.getAddress(ethers.dataSlice(initCode, 0, 20));
    const initCallData = ethers.dataSlice(initCode, 20);
    await deployer
      .sendTransaction({ to: factory, data: initCallData })
      .then(async (tx) => tx.wait());
  }

  getInitCode(): string {
    if (!this.safeConfig) throw Error("Init code not available");
    const initParams = buildInitParamsForConfig(
      this.safeConfig,
      this.globalConfig,
    );
    return initParams.initCode;
  }

  async getSigners(): Promise<string[]> {
    if (!this.provider || !(await this.isDeployed())) {
      if (!this.safeConfig) throw Error("Not deployed and no config available");
      return this.safeConfig.signers;
    }
    const result = await callInterface(
      this.provider,
      this.address,
      "getOwners",
      [],
    );
    return result[0];
  }

  async getModules(): Promise<string[]> {
    if (!this.provider || !(await this.isDeployed())) {
      if (!this.safeConfig) throw Error("Not deployed and no config available");
      return [this.globalConfig.erc4337module];
    }
    const result = await callInterface(
      this.provider,
      this.address,
      "getModulesPaginated",
      [AddressOne, 10],
    );
    return result[0];
  }

  async getThreshold(): Promise<number> {
    if (!this.provider || !(await this.isDeployed())) {
      if (!this.safeConfig) throw Error("Not deployed and no config available");
      return this.safeConfig.threshold;
    }
    const result = await callInterface(
      this.provider,
      this.address,
      "getThreshold",
      [],
    );
    return result[0];
  }

  async operate(action: MetaTransaction): Promise<Safe4337Operation> {
    if (!this.provider) throw Error("Missing provider");
    return Safe4337Operation.build(
      this.provider,
      this,
      action,
      this.globalConfig,
    );
  }

  static async withSigner(
    signer: string,
    globalConfig: GlobalConfig,
  ): Promise<Safe4337> {
    const safeConfig: SafeConfig = {
      signers: [signer],
      threshold: 1,
      nonce: 0,
    };
    return Safe4337.withConfigs(safeConfig, globalConfig);
  }

  static async withConfigs(
    safeConfig: SafeConfig,
    globalConfig: GlobalConfig,
  ): Promise<Safe4337> {
    const initParams = buildInitParamsForConfig(safeConfig, globalConfig);
    return new Safe4337(initParams.safeAddress, globalConfig, safeConfig);
  }
}
