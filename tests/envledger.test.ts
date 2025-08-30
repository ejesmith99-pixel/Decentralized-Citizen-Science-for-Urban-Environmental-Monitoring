import { describe, expect, it, vi, beforeEach } from "vitest";

// Interfaces for type safety
interface ClarityResponse<T> {
  ok: boolean;
  value: T | number; // number for error codes
}

interface EnvironmentalData {
  dataType: string;
  value: number;
  locationLat: number;
  locationLon: number;
  timestamp: number;
  contributor: string;
  evidenceHash: Buffer;
  metadata: string;
  tags: string[];
  validatedAt: number;
  qualityScore: number;
}

interface AggregateStats {
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
}

interface NftInfo {
  owner: string;
  minted: boolean;
  tokenId: number;
}

interface ContractState {
  environmentalData: Map<number, EnvironmentalData>;
  dataByType: Map<string, Set<number>>; // data-type -> set of data-ids
  dataByLocation: Map<string, Set<number>>; // location-hash -> set of data-ids
  dataByTimestamp: Map<number, Set<number>>; // timestamp -> set of data-ids
  dataByContributor: Map<string, Set<number>>; // contributor -> set of data-ids
  aggregateStats: Map<string, AggregateStats>; // `${data-type}_${period}` -> stats
  dataNfts: Map<number, NftInfo>;
  contractPaused: boolean;
  admin: string;
  validationPool: string;
  dataCounter: number;
}

// Mock contract implementation
class EnvLedgerMock {
  private state: ContractState = {
    environmentalData: new Map(),
    dataByType: new Map(),
    dataByLocation: new Map(),
    dataByTimestamp: new Map(),
    dataByContributor: new Map(),
    aggregateStats: new Map(),
    dataNfts: new Map(),
    contractPaused: false,
    admin: "deployer",
    validationPool: "validation_pool",
    dataCounter: 0,
  };

  private ERR_NOT_AUTHORIZED = 100;
  private ERR_INVALID_DATA = 101;
  private ERR_DATA_EXISTS = 102;
  private ERR_NOT_FOUND = 104;
  private ERR_PAUSED = 105;
  private ERR_INVALID_TIMESTAMP = 106;
  private ERR_INVALID_LOCATION = 107;
  private ERR_INVALID_EVIDENCE = 108;
  private MAX_TAGS = 10;
  private MAX_METADATA_LEN = 500;

  private computeLocationHash(lat: number, lon: number): string {
    // Mock hash function
    return `${lat}_${lon}`;
  }

  private updateIndexes(dataId: number, data: EnvironmentalData): void {
    // Update type index
    if (!this.state.dataByType.has(data.dataType)) {
      this.state.dataByType.set(data.dataType, new Set());
    }
    this.state.dataByType.get(data.dataType)!.add(dataId);

    // Update location index
    const locHash = this.computeLocationHash(data.locationLat, data.locationLon);
    if (!this.state.dataByLocation.has(locHash)) {
      this.state.dataByLocation.set(locHash, new Set());
    }
    this.state.dataByLocation.get(locHash)!.add(dataId);

    // Update timestamp index
    if (!this.state.dataByTimestamp.has(data.timestamp)) {
      this.state.dataByTimestamp.set(data.timestamp, new Set());
    }
    this.state.dataByTimestamp.get(data.timestamp)!.add(dataId);

    // Update contributor index
    if (!this.state.dataByContributor.has(data.contributor)) {
      this.state.dataByContributor.set(data.contributor, new Set());
    }
    this.state.dataByContributor.get(data.contributor)!.add(dataId);

    // Update aggregates
    this.updateAggregates(data);
  }

  private updateAggregates(data: EnvironmentalData): void {
    const period = Math.floor(data.timestamp / 86400);
    const key = `${data.dataType}_${period}`;
    const current = this.state.aggregateStats.get(key) ?? {
      count: 0,
      sum: 0,
      min: Number.MAX_SAFE_INTEGER,
      max: Number.MIN_SAFE_INTEGER,
      avg: 0,
    };
    const newCount = current.count + 1;
    const newSum = current.sum + data.value;
    const newMin = Math.min(current.min, data.value);
    const newMax = Math.max(current.max, data.value);
    const newAvg = Math.floor(newSum / newCount);
    this.state.aggregateStats.set(key, {
      count: newCount,
      sum: newSum,
      min: newMin,
      max: newMax,
      avg: newAvg,
    });
  }

  addValidatedData(
    caller: string,
    dataType: string,
    value: number,
    locationLat: number,
    locationLon: number,
    timestamp: number,
    contributor: string,
    evidenceHash: Buffer,
    metadata: string,
    tags: string[],
    qualityScore: number
  ): ClarityResponse<number> {
    if (this.state.contractPaused) {
      return { ok: false, value: this.ERR_PAUSED };
    }
    if (caller !== this.state.admin && caller !== this.state.validationPool) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    if (dataType.length === 0) {
      return { ok: false, value: this.ERR_INVALID_DATA };
    }
    if (locationLat < -90000000 || locationLat > 90000000 || locationLon < -180000000 || locationLon > 180000000) {
      return { ok: false, value: this.ERR_INVALID_LOCATION };
    }
    if (timestamp <= 0) {
      return { ok: false, value: this.ERR_INVALID_TIMESTAMP };
    }
    if (evidenceHash.every(byte => byte === 0)) {
      return { ok: false, value: this.ERR_INVALID_EVIDENCE };
    }
    if (tags.length > this.MAX_TAGS || metadata.length > this.MAX_METADATA_LEN || qualityScore > 100) {
      return { ok: false, value: this.ERR_INVALID_DATA };
    }

    const dataId = this.state.dataCounter + 1;
    const data: EnvironmentalData = {
      dataType,
      value,
      locationLat,
      locationLon,
      timestamp,
      contributor,
      evidenceHash,
      metadata,
      tags,
      validatedAt: 1000, // Mock block height
      qualityScore,
    };
    this.state.environmentalData.set(dataId, data);
    this.updateIndexes(dataId, data);
    this.state.dataCounter = dataId;
    return { ok: true, value: dataId };
  }

  pauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.contractPaused = true;
    return { ok: true, value: true };
  }

  unpauseContract(caller: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.contractPaused = false;
    return { ok: true, value: true };
  }

  setAdmin(caller: string, newAdmin: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.admin = newAdmin;
    return { ok: true, value: true };
  }

  setValidationPool(caller: string, newPool: string): ClarityResponse<boolean> {
    if (caller !== this.state.admin) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    this.state.validationPool = newPool;
    return { ok: true, value: true };
  }

  mintDataNft(caller: string, dataId: number, tokenId: number): ClarityResponse<boolean> {
    const data = this.state.environmentalData.get(dataId);
    if (!data) {
      return { ok: false, value: this.ERR_NOT_FOUND };
    }
    if (caller !== data.contributor) {
      return { ok: false, value: this.ERR_NOT_AUTHORIZED };
    }
    const nft = this.state.dataNfts.get(dataId);
    if (nft?.minted) {
      return { ok: false, value: this.ERR_DATA_EXISTS };
    }
    this.state.dataNfts.set(dataId, { owner: caller, minted: true, tokenId });
    return { ok: true, value: true };
  }

  getData(dataId: number): ClarityResponse<EnvironmentalData | null> {
    return { ok: true, value: this.state.environmentalData.get(dataId) ?? null };
  }

  getDataByType(dataType: string, startId: number, limit: number): ClarityResponse<(EnvironmentalData | null)[]> {
    const ids = this.state.dataByType.get(dataType) ?? new Set();
    const result: (EnvironmentalData | null)[] = [];
    let count = 0;
    for (const id of ids) {
      if (id >= startId && count < limit) {
        result.push(this.state.environmentalData.get(id) ?? null);
        count++;
      }
    }
    return { ok: true, value: result };
  }

  getDataByLocation(lat: number, lon: number, startId: number, limit: number): ClarityResponse<(EnvironmentalData | null)[]> {
    const locHash = this.computeLocationHash(lat, lon);
    const ids = this.state.dataByLocation.get(locHash) ?? new Set();
    const result: (EnvironmentalData | null)[] = [];
    let count = 0;
    for (const id of ids) {
      if (id >= startId && count < limit) {
        result.push(this.state.environmentalData.get(id) ?? null);
        count++;
      }
    }
    return { ok: true, value: result };
  }

  getDataByTimestamp(timestamp: number, limit: number): ClarityResponse<(EnvironmentalData | null)[]> {
    const ids = this.state.dataByTimestamp.get(timestamp) ?? new Set();
    const result: (EnvironmentalData | null)[] = [];
    let count = 0;
    for (const id of ids) {
      if (count < limit) {
        result.push(this.state.environmentalData.get(id) ?? null);
        count++;
      }
    }
    return { ok: true, value: result };
  }

  getDataByContributor(contributor: string, startId: number, limit: number): ClarityResponse<(EnvironmentalData | null)[]> {
    const ids = this.state.dataByContributor.get(contributor) ?? new Set();
    const result: (EnvironmentalData | null)[] = [];
    let count = 0;
    for (const id of ids) {
      if (id >= startId && count < limit) {
        result.push(this.state.environmentalData.get(id) ?? null);
        count++;
      }
    }
    return { ok: true, value: result };
  }

  getAggregateStats(dataType: string, period: number): ClarityResponse<AggregateStats | null> {
    const key = `${dataType}_${period}`;
    return { ok: true, value: this.state.aggregateStats.get(key) ?? null };
  }

  getNftInfo(dataId: number): ClarityResponse<NftInfo | null> {
    return { ok: true, value: this.state.dataNfts.get(dataId) ?? null };
  }

  isPaused(): ClarityResponse<boolean> {
    return { ok: true, value: this.state.contractPaused };
  }

  getAdmin(): ClarityResponse<string> {
    return { ok: true, value: this.state.admin };
  }

  getValidationPool(): ClarityResponse<string> {
    return { ok: true, value: this.state.validationPool };
  }

  getDataCounter(): ClarityResponse<number> {
    return { ok: true, value: this.state.dataCounter };
  }
}

// Test setup
const accounts = {
  deployer: "deployer",
  validationPool: "validation_pool",
  contributor: "contributor_1",
  user: "user_1",
};

describe("EnvLedger Contract", () => {
  let contract: EnvLedgerMock;

  beforeEach(() => {
    contract = new EnvLedgerMock();
    vi.resetAllMocks();
  });

  it("should allow authorized caller to add validated data", () => {
    const evidenceHash = Buffer.from("12345678901234567890123456789012"); // 32 bytes
    const addResult = contract.addValidatedData(
      accounts.validationPool,
      "PM2.5",
      250,
      40712345, // ~40.712345
      -74000000, // ~-74.000000
      1725000000,
      accounts.contributor,
      evidenceHash,
      "High pollution near highway",
      ["urban", "air-quality"],
      85
    );
    expect(addResult).toEqual({ ok: true, value: 1 });

    const data = contract.getData(1);
    expect(data.ok).toBe(true);
    expect(data.value).toMatchObject({
      dataType: "PM2.5",
      value: 250,
      qualityScore: 85,
    });
  });

  it("should prevent unauthorized caller from adding data", () => {
    const evidenceHash = Buffer.alloc(32);
    const addResult = contract.addValidatedData(
      accounts.user,
      "PM2.5",
      250,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Test",
      [],
      85
    );
    expect(addResult).toEqual({ ok: false, value: 100 });
  });

  it("should validate input data correctly", () => {
    const evidenceHash = Buffer.alloc(32); // All zeros, invalid
    const addResult = contract.addValidatedData(
      accounts.validationPool,
      "",
      250,
      40712345,
      -74000000,
      0,
      accounts.contributor,
      evidenceHash,
      "Test",
      [],
      101 // Invalid score
    );
    expect(addResult).toEqual({ ok: false, value: 101 }); // First error is empty type
  });

  it("should update aggregates on data addition", () => {
    const evidenceHash = Buffer.from("12345678901234567890123456789012");
    contract.addValidatedData(
      accounts.validationPool,
      "temperature",
      25,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Warm day",
      [],
      90
    );

    const period = Math.floor(1725000000 / 86400);
    const stats = contract.getAggregateStats("temperature", period);
    expect(stats).toEqual({
      ok: true,
      value: { count: 1, sum: 25, min: 25, max: 25, avg: 25 },
    });
  });

  it("should allow minting NFT for data", () => {
    const evidenceHash = Buffer.from("12345678901234567890123456789012");
    contract.addValidatedData(
      accounts.validationPool,
      "noise",
      80,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Loud area",
      [],
      95
    );

    const mintResult = contract.mintDataNft(accounts.contributor, 1, 1001);
    expect(mintResult).toEqual({ ok: true, value: true });

    const nftInfo = contract.getNftInfo(1);
    expect(nftInfo).toEqual({
      ok: true,
      value: { owner: accounts.contributor, minted: true, tokenId: 1001 },
    });
  });

  it("should prevent double minting NFT", () => {
    const evidenceHash = Buffer.from("12345678901234567890123456789012");
    contract.addValidatedData(
      accounts.validationPool,
      "noise",
      80,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Loud area",
      [],
      95
    );
    contract.mintDataNft(accounts.contributor, 1, 1001);

    const secondMint = contract.mintDataNft(accounts.contributor, 1, 1002);
    expect(secondMint).toEqual({ ok: false, value: 102 });
  });

  it("should query data by type", () => {
    const evidenceHash = Buffer.from("12345678901234567890123456789012");
    contract.addValidatedData(
      accounts.validationPool,
      "PM2.5",
      250,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Test1",
      [],
      85
    );
    contract.addValidatedData(
      accounts.validationPool,
      "PM2.5",
      300,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Test2",
      [],
      90
    );

    const query = contract.getDataByType("PM2.5", 0, 10);
    expect(query.ok).toBe(true);
    expect((query.value as EnvironmentalData[]).length).toBe(2);
  });

  it("should pause and unpause contract", () => {
    const pauseResult = contract.pauseContract(accounts.deployer);
    expect(pauseResult).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: true });

    const evidenceHash = Buffer.from("12345678901234567890123456789012");
    const addDuringPause = contract.addValidatedData(
      accounts.validationPool,
      "PM2.5",
      250,
      40712345,
      -74000000,
      1725000000,
      accounts.contributor,
      evidenceHash,
      "Paused add",
      [],
      85
    );
    expect(addDuringPause).toEqual({ ok: false, value: 105 });

    const unpauseResult = contract.unpauseContract(accounts.deployer);
    expect(unpauseResult).toEqual({ ok: true, value: true });
    expect(contract.isPaused()).toEqual({ ok: true, value: false });
  });

  it("should prevent non-admin from pausing", () => {
    const pauseResult = contract.pauseContract(accounts.user);
    expect(pauseResult).toEqual({ ok: false, value: 100 });
  });
});
