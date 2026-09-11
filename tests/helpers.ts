import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
export function database() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0001_initial.sql", import.meta.url),
      "utf8",
    ),
  );
  const prepare = (sql: string, args: unknown[] = []): any => ({
    bind: (...v: unknown[]) => prepare(sql, v),
    first: async () => sqlite.prepare(sql).get(...(args as any[])) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = sqlite.prepare(sql).run(...(args as any[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  const db: any = {
    prepare,
    batch: async (q: any[]) => {
      sqlite.exec("BEGIN");
      try {
        const result = [];
        for (const s of q) result.push(await s.run());
        sqlite.exec("COMMIT");
        return result;
      } catch (e) {
        sqlite.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { sqlite, db };
}
export function bucket() {
  const objects = new Map<string, { bytes: Uint8Array; metadata: any }>();
  return {
    objects,
    put: async (key: string, input: any, opts: any = {}) => {
      const bytes =
        input instanceof Uint8Array
          ? input
          : new Uint8Array(await new Response(input).arrayBuffer());
      objects.set(key, { bytes, metadata: opts.customMetadata });
    },
    get: async (key: string) => {
      const o = objects.get(key);
      return o
        ? {
            body: new Blob([o.bytes as BlobPart]).stream(),
            size: o.bytes.length,
            customMetadata: o.metadata,
          }
        : null;
    },
    head: async (key: string) => {
      const o = objects.get(key);
      return o ? { size: o.bytes.length, customMetadata: o.metadata } : null;
    },
    delete: async (keys: string | string[]) => {
      for (const k of [keys].flat()) objects.delete(k);
    },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((key) => ({ key })),
      truncated: false,
    }),
  };
}
