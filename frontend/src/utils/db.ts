import Dexie, { type Table } from 'dexie';
import type { RingRecord } from '../types/ring-record';
import type { Morphometrics, MeasureReview, ReviewOutboxItem, SpeciesBaseline } from '../types/morphometrics';
import type { BirdSite } from '../types/bird-site';
import type { SurveySession } from '../types/session';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbbirdring-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class BirdRingDB extends Dexie {
  rings!: Table<RingRecord, string>;
  /** 环志组侧：现场原始量度数值，不被资料室改动 */
  morphs!: Table<Morphometrics, string>;
  /** 资料室侧：复核结论 / 存疑 / 复测 / 另存修正值 */
  reviews!: Table<MeasureReview, string>;
  /** 资料室侧：同鸟种按季核定的均线 */
  baselines!: Table<SpeciesBaseline, string>;
  sites!: Table<BirdSite, string>;
  sessions!: Table<SurveySession, string>;
  /** 资料室侧：复核提交失败后的待重试队列（payload 为 ReviewInput 的 JSON 字符串） */
  reviewOutbox!: Table<ReviewOutboxItem, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      rings: 'id, ringNo, speciesCn, status, ringDate, siteId, sessionId',
      morphs: 'id, ringId, measuredAt',
      sites: 'id, siteNo, habitat, name',
      sessions: 'id, sessionNo, date, siteId, closed',
      meta: 'key',
    });

    // v2：环志表增加 (speciesCn+ringDate) 复合索引，鸟种按日期检索更快；并回填历史彩环字段。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        rings: 'id, ringNo, speciesCn, status, ringDate, siteId, sessionId, [speciesCn+ringDate]',
        morphs: 'id, ringId, measuredAt',
        sites: 'id, siteNo, habitat, name',
        sessions: 'id, sessionNo, date, siteId, closed',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('rings')
          .toCollection()
          .modify((row: RingRecord) => {
            if (typeof row.colorRing !== 'string') {
              row.colorRing = '无';
            }
          });
      });

    // v3：把现场量度与资料室复核分成两侧。
    // morphs 表保持为环志组现场原始数值（旧数据即原始数值，原样保留），
    // 新增 reviews（复核结论）、baselines（按季核定均线）、reviewOutbox（提交失败重试）三张资料室侧的表。
    this.version(3)
      .stores({
        rings: 'id, ringNo, speciesCn, status, ringDate, siteId, sessionId, [speciesCn+ringDate]',
        morphs: 'id, ringId, measuredAt',
        reviews: 'id, morphId, status, reviewedAt',
        baselines: 'id, [speciesCn+quarter], quarter, approvedAt',
        reviewOutbox: 'id, createdAt',
        sites: 'id, siteNo, habitat, name',
        sessions: 'id, sessionNo, date, siteId, closed',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        // 旧数据升级：原来那些量度算现场原始数值（morphs 不动），
        // 资料室侧没有任何复核结论，旧量度一律按「待复核」进入复核队列，等资料室按新流程处理。
        const reviews = tx.table<MeasureReview, string>('reviews');
        const existingMorphs = await tx.table<Morphometrics, string>('morphs').toArray();
        await reviews.bulkAdd(
          existingMorphs.map((morph) => ({
            id: `review-${morph.id}`,
            morphId: morph.id,
            status: '待复核' as const,
            reviewedBy: '',
            reviewedAt: '',
          })),
        );
      });
  }
}

export const db = new BirdRingDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
