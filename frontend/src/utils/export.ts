import { db, SCHEMA_VERSION } from './db';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  rings: unknown[];
  morphs: unknown[];
  reviews: unknown[];
  baselines: unknown[];
  sites: unknown[];
  sessions: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [rings, morphs, reviews, baselines, sites, sessions] = await Promise.all([
    db.rings.toArray(),
    db.morphs.toArray(),
    db.reviews.toArray(),
    db.baselines.toArray(),
    db.sites.toArray(),
    db.sessions.toArray(),
  ]);
  return {
    app: 'gbbirdring',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    rings,
    morphs,
    reviews,
    baselines,
    sites,
    sessions,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（环志汇总表打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

/** 恢复 JSON 备份 */
export async function importBackup(text: string): Promise<{ rings: number; morphs: number; reviews: number; baselines: number; sites: number; sessions: number }> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbbirdring') {
    throw new Error('备份文件格式不匹配（缺少 app=gbbirdring 标记）');
  }
  const counts = {
    rings: payload.rings?.length ?? 0,
    morphs: payload.morphs?.length ?? 0,
    reviews: payload.reviews?.length ?? 0,
    baselines: payload.baselines?.length ?? 0,
    sites: payload.sites?.length ?? 0,
    sessions: payload.sessions?.length ?? 0,
  };
  await db.transaction(
    'rw',
    [db.rings, db.morphs, db.reviews, db.baselines, db.reviewOutbox, db.sites, db.sessions],
    async () => {
      await Promise.all([
        db.rings.clear(),
        db.morphs.clear(),
        db.reviews.clear(),
        db.baselines.clear(),
        db.reviewOutbox.clear(),
        db.sites.clear(),
        db.sessions.clear(),
      ]);
      if (payload.rings?.length) await db.rings.bulkPut(payload.rings as never[]);
      if (payload.morphs?.length) await db.morphs.bulkPut(payload.morphs as never[]);
      if (payload.reviews?.length) await db.reviews.bulkPut(payload.reviews as never[]);
      if (payload.baselines?.length) await db.baselines.bulkPut(payload.baselines as never[]);
      if (payload.sites?.length) await db.sites.bulkPut(payload.sites as never[]);
      if (payload.sessions?.length) await db.sessions.bulkPut(payload.sessions as never[]);

      // 旧版备份（v2 及以前，只有现场量度、没有复核侧）：恢复后按迁移规则拆两侧，
      // 原来那些量度算现场原始数值，并补建「待复核」记录。
      const morphIds = new Set((payload.morphs as Array<{ id?: string }> | undefined)?.map((m) => m.id).filter(Boolean) as string[]);
      const reviewedMorphIds = new Set(
        (payload.reviews as Array<{ morphId?: string }> | undefined)?.map((r) => r.morphId).filter(Boolean) as string[],
      );
      const missing: Array<{ id: string; morphId: string; status: '待复核'; reviewedBy: string; reviewedAt: string }> = [];
      morphIds.forEach((morphId) => {
        if (!reviewedMorphIds.has(morphId)) {
          missing.push({ id: `review-${morphId}`, morphId, status: '待复核', reviewedBy: '', reviewedAt: '' });
        }
      });
      if (missing.length) await db.reviews.bulkPut(missing as never[]);
    },
  );
  return counts;
}
