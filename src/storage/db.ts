// IndexedDB 本地持久化。无服务器，所有数据仅保存在浏览器本地。
// v2：在同一张 formulas 表上增加不确定度声明（variables[].uncertainty/source、
// correlations）与计算快照 snapshots；v1 旧库升级时仅确认表存在，旧记录缺字段
// 时由引擎按“不确定度未声明”处理，普通结果语义不变。
import type { Formula } from "../engine/types";

const DB_NAME = "dimension-notebook";
const STORE = "formulas";
const VERSION = 2;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // v1 → v2：表结构不变（记录按整体对象存取），仅在全新建库时创建表
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      // 旧记录保持原样：缺省的 correlations/snapshots 在读取与分析时按缺省处理
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = run(t.objectStore(STORE));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      }),
  );
}

export const db = {
  async all(): Promise<Formula[]> {
    const rows = await tx<Formula[]>("readonly", (s) => s.getAll() as IDBRequest<Formula[]>);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  },
  async put(formula: Formula): Promise<void> {
    await tx<IDBValidKey>("readwrite", (s) => s.put(formula));
  },
  async bulkPut(formulas: Formula[]): Promise<void> {
    const database = await openDB();
    await new Promise<void>((resolve, reject) => {
      const t = database.transaction(STORE, "readwrite");
      const store = t.objectStore(STORE);
      for (const f of formulas) store.put(f);
      t.oncomplete = () => { resolve(); database.close(); };
      t.onerror = () => { reject(t.error); database.close(); };
    });
  },
  async delete(id: string): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.delete(id) as IDBRequest<undefined>);
  },
  async clear(): Promise<void> {
    await tx<undefined>("readwrite", (s) => s.clear() as IDBRequest<undefined>);
  },
};

export function newId(): string {
  return `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
