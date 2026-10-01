// IndexedDB v1 → v2 升级与持久化往返（使用 fake-indexeddb，在 Node 中验证真实 IDB 行为）
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { db, newId } from "./db";
import { analyzeFormula } from "../engine/math";
import type { Formula } from "../engine/types";

const DB_NAME = "dimension-notebook";
const STORE = "formulas";

function openAt(version: number, onUpgrade?: (db: IDBDatabase, oldV: number) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = (ev) => onUpgrade?.(req.result, ev.oldVersion);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function resetDB() {
  await new Promise<void>((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

const oldFormula = (): Formula => ({
  id: newId(),
  latex: "p+q",
  note: "旧笔记本记录",
  variables: { p: { value: "10", unit: "N" }, q: { value: "5", unit: "N" } },
  targetUnit: "",
  createdAt: 5,
});

const newFormula = (): Formula => ({
  id: newId(),
  latex: "m*a",
  note: "新记录",
  variables: {
    m: { value: "2", unit: "kg", uncertainty: "0.1" },
    a: { value: "3", unit: "m/s^2", uncertainty: "0.2" },
  },
  targetUnit: "",
  correlations: [{ a: "m", b: "a", rho: "0.8", source: "同一台标定台" }],
  snapshots: [{
    id: newId(),
    savedAt: 1234567890,
    latex: "m*a",
    source: "(m)*(a)",
    substituted: "((2 kg))*((3 m / s^2))",
    originalTex: "m \\cdot a",
    substitutedTex: "2\\,\\mathrm{kg} \\cdot 3\\,\\mathrm{m}/\\mathrm{s}^{2}",
    status: "ok",
    summary: "= 6 N",
    value: 6,
    resultUnit: "N",
    uncertainty: {
      status: "propagated",
      standardUncertainty: 0.66483,
      relativeUncertainty: 0.110805,
      issues: [],
      contributors: [
        { variable: "a", variance: 0.16, share: 0.36 },
        { variable: "m", variance: 0.09, share: 0.20 },
      ],
      correlationTerms: [{ a: "m", b: "a", rho: 0.8, variance: 0.192, share: 0.43, source: "同一台标定台" }],
      assumption: "已声明 1 对相关关系",
    },
  }],
  createdAt: 9,
});

beforeEach(resetDB);

describe("IndexedDB 版本升级", () => {
  it("v1 数据库（无新字段）经 db.ts（VERSION=2）打开时自动升级且旧记录原样可读", async () => {
    // 1) 以 v1 建库并写入旧形态记录
    const old = oldFormula();
    const v1 = await openAt(1, (database) => {
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
    });
    await new Promise<void>((resolve, reject) => {
      const t = v1.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(old);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    v1.close();

    // 2) db.ts 以 v2 打开（触发 onupgradeneeded: oldVersion=1）
    const rows = await db.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(old);
    expect(rows[0].correlations).toBeUndefined();
    expect(rows[0].snapshots).toBeUndefined();
    expect(rows[0].variables.p.uncertainty).toBeUndefined();

    // 3) 旧记录仍可算，且明确“不确定度未声明”
    const r = analyzeFormula(rows[0].latex, rows[0].variables, rows[0].targetUnit);
    expect(r.status).toBe("ok");
    expect(r.value).toBe(15);
    expect(r.uncertainty!.status).toBe("undeclared");
  });

  it("v2 写入的新字段（相关关系、快照、不确定度）再次读取不丢失", async () => {
    const f = newFormula();
    await db.put(f);
    const rows = await db.all();
    expect(rows).toHaveLength(1);
    expect(rows[0].correlations).toEqual(f.correlations);
    expect(rows[0].variables.m.uncertainty).toBe("0.1");
    expect(rows[0].snapshots).toHaveLength(1);
    expect(rows[0].snapshots![0].uncertainty?.correlationTerms?.[0].source).toBe("同一台标定台");

    // 直接确认数据库版本为 2
    const v = await new Promise<number>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => { resolve(req.result.version); req.result.close(); };
      req.onerror = () => reject(req.error);
    });
    expect(v).toBe(2);
  });

  it("升级后 v1 与 v2 记录可在同一库中共存且分别可分析", async () => {
    const old = oldFormula();
    const v1 = await openAt(1, (database) => {
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
    });
    await new Promise<void>((resolve, reject) => {
      const t = v1.transaction(STORE, "readwrite");
      t.objectStore(STORE).put(old);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
    v1.close();

    const f = newFormula();
    await db.put(f);
    const rows = await db.all();
    expect(rows).toHaveLength(2);
    const legacy = rows.find((x) => x.id === old.id)!;
    const modern = rows.find((x) => x.id === f.id)!;
    expect(analyzeFormula(legacy.latex, legacy.variables, "").uncertainty!.status).toBe("undeclared");
    const r2 = analyzeFormula(modern.latex, modern.variables, "", modern.correlations);
    expect(r2.value).toBe(6);
    expect(r2.uncertainty!.status).toBe("propagated");
    expect(r2.uncertainty!.standardUncertainty!).toBeCloseTo(Math.sqrt(0.442), 6);
  });
});
