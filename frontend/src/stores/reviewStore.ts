import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import {
  isOpenStatus,
  type MeasureBaselineSet,
  type MeasureKey,
  type MeasureValueSet,
  type MeasureReview,
  type ReviewOutboxItem,
  type ReviewStatus,
  type SpeciesBaseline,
} from '../types/morphometrics';

/** 资料室提交复核结论的入参 */
export interface ReviewInput {
  morphId: string;
  status: ReviewStatus;
  corrected?: Partial<MeasureValueSet>;
  note?: string;
  doubtKeys?: MeasureKey[];
  remeasureKeys?: MeasureKey[];
  reviewedBy: string;
  /** 结论所依据的均线快照（均值 + 标准差） */
  baselineSnapshot?: MeasureBaselineSet;
}

/** 队列条目（payload 反序列化后的形态，供页面使用） */
export type ReviewOutboxEntry = Omit<ReviewOutboxItem, 'payload'> & { payload: ReviewInput };

interface ReviewState {
  reviews: MeasureReview[];
  baselines: SpeciesBaseline[];
  outbox: ReviewOutboxEntry[];
  hydrated: boolean;
}

/**
 * 资料室侧：复核结论、存疑/复测、另存修正值、按季均线核定，以及提交失败重试。
 * 本 store 不写 morphs 表 —— 现场原始数值归环志组（measureStore），资料室只在本侧落结论。
 */
export const useReviewStore = defineStore('review', {
  state: (): ReviewState => ({ reviews: [], baselines: [], outbox: [], hydrated: false }),

  getters: {
    reviewByMorph(state): (morphId: string) => MeasureReview | undefined {
      return (morphId: string) => state.reviews.find((review) => review.morphId === morphId);
    },
    /** 各状态数量 */
    statusCounts(state): Record<ReviewStatus, number> {
      const counts: Record<ReviewStatus, number> = {
        待复核: 0,
        维持原值: 0,
        存疑: 0,
        复测: 0,
        已修正: 0,
        两边不符: 0,
      };
      state.reviews.forEach((review) => {
        counts[review.status] += 1;
      });
      return counts;
    },
    /** 同鸟种 + 季度已核定的均线（资料室按季核定） */
    baselineOf(state) {
      return (speciesCn: string, quarter: string): SpeciesBaseline | undefined =>
        state.baselines.find((item) => item.speciesCn === speciesCn && item.quarter === quarter);
    },
    /** 提交失败、等待重试的条目数 */
    pendingRetryCount(state): number {
      return state.outbox.length;
    },
  },

  actions: {
    async hydrate() {
      const [reviews, baselines, outboxRaw] = await Promise.all([
        db.reviews.orderBy('reviewedAt').reverse().toArray() as Promise<MeasureReview[]>,
        db.baselines.orderBy('approvedAt').reverse().toArray() as Promise<SpeciesBaseline[]>,
        db.reviewOutbox.orderBy('createdAt').toArray(),
      ]);
      // reviewedAt 为空（待复核）的记录排在最后
      this.reviews = reviews.sort((a, b) => (b.reviewedAt || '').localeCompare(a.reviewedAt || ''));
      this.baselines = baselines;
      this.outbox = outboxRaw.map((item) => ({ ...item, payload: JSON.parse(item.payload) as ReviewInput }));
      this.hydrated = true;
    },

    /**
     * 提交一条复核结论。落库失败时不丢结论 —— 进入发件箱等重试（见 retryOutbox）。
     * 注意：这里只写资料室侧（reviews），绝不改 morphs 里的现场原始数值。
     */
    async submitReview(input: ReviewInput): Promise<{ ok: boolean; queued?: boolean }> {
      const existing = this.reviews.find((review) => review.morphId === input.morphId);
      const review: MeasureReview = {
        id: existing?.id ?? `review-${input.morphId}`,
        morphId: input.morphId,
        status: input.status,
        corrected: input.corrected && Object.keys(input.corrected).length ? toPlain(input.corrected) : undefined,
        note: input.note?.trim() || undefined,
        doubtKeys: input.doubtKeys?.length ? [...input.doubtKeys] : undefined,
        remeasureKeys: input.remeasureKeys?.length ? [...input.remeasureKeys] : undefined,
        reviewedBy: input.reviewedBy.trim(),
        reviewedAt: new Date().toISOString(),
        baselineSnapshot: input.baselineSnapshot ? toPlain(input.baselineSnapshot) : existing?.baselineSnapshot,
      };
      try {
        await db.reviews.put(toPlain(review));
        this.upsertLocal(review);
        return { ok: true };
      } catch (error) {
        // 提交失败：结论转存发件箱，稍后可一键重试，不阻塞资料室继续工作
        const stored: ReviewOutboxItem = {
          id: uid('outbox'),
          payload: JSON.stringify(toPlain(input)),
          createdAt: new Date().toISOString(),
          lastError: (error as Error).message,
        };
        await db.reviewOutbox.put(toPlain(stored));
        const entry: ReviewOutboxEntry = { ...stored, payload: input };
        this.outbox = [...this.outbox, entry];
        return { ok: false, queued: true };
      }
    },

    /**
     * 重试发件箱里提交失败的复核结论。逐条落库，成功即移出队列；仍失败的保留错误信息继续等下次重试。
     */
    async retryOutbox(): Promise<{ succeeded: number; failed: number }> {
      let succeeded = 0;
      let failed = 0;
      for (const item of [...this.outbox]) {
        const input = item.payload;
        const existing = this.reviews.find((review) => review.morphId === input.morphId);
        const review: MeasureReview = {
          id: existing?.id ?? `review-${input.morphId}`,
          morphId: input.morphId,
          status: input.status,
          corrected: input.corrected && Object.keys(input.corrected).length ? toPlain(input.corrected) : undefined,
          note: input.note?.trim() || undefined,
          doubtKeys: input.doubtKeys?.length ? [...input.doubtKeys] : undefined,
          remeasureKeys: input.remeasureKeys?.length ? [...input.remeasureKeys] : undefined,
          reviewedBy: input.reviewedBy.trim(),
          reviewedAt: new Date().toISOString(),
          baselineSnapshot: input.baselineSnapshot ? toPlain(input.baselineSnapshot) : existing?.baselineSnapshot,
        };
        try {
          await db.reviews.put(toPlain(review));
          await db.reviewOutbox.delete(item.id);
          this.upsertLocal(review);
          this.outbox = this.outbox.filter((queued: ReviewOutboxEntry) => queued.id !== item.id);
          succeeded += 1;
        } catch (error) {
          const stored: ReviewOutboxItem = {
            id: item.id,
            payload: JSON.stringify(toPlain(input)),
            createdAt: item.createdAt,
            retriedAt: new Date().toISOString(),
            lastError: (error as Error).message,
          };
          await db.reviewOutbox.put(toPlain(stored));
          this.outbox = this.outbox.map((queued: ReviewOutboxEntry) =>
            queued.id === item.id ? { ...stored, payload: input } : queued,
          );
          failed += 1;
        }
      }
      return { succeeded, failed };
    },

    /** 丢弃一条发件箱待重试记录 */
    async discardOutbox(id: string) {
      await db.reviewOutbox.delete(id);
      this.outbox = this.outbox.filter((item: ReviewOutboxEntry) => item.id !== id);
    },

    /**
     * 资料室按季核定同鸟种均线。
     * 核定后：该鸟种当季「还没定论」的复核重新比对（打上重新比对时间，范围由
     * recompareMorphIds 按鸟种+季度圈定）；
     * 已定论（维持原值 / 已修正）的结论与现场原始数值一律不动。
     */
    async approveBaseline(input: {
      speciesCn: string;
      quarter: string;
      values: MeasureBaselineSet;
      approvedBy: string;
      note?: string;
      /** 该鸟种当季、尚未定论、需要重新比对的现场量度 id */
      recompareMorphIds?: string[];
    }): Promise<{ baseline: SpeciesBaseline; recompared: number }> {
      const existing = this.baselineOf(input.speciesCn, input.quarter);
      const baseline: SpeciesBaseline = {
        id: existing?.id ?? uid('baseline'),
        speciesCn: input.speciesCn,
        quarter: input.quarter,
        values: toPlain(input.values),
        approvedBy: input.approvedBy.trim(),
        approvedAt: new Date().toISOString(),
        note: input.note?.trim() || existing?.note,
      };
      const scope = new Set(input.recompareMorphIds ?? []);
      await db.baselines.put(toPlain(baseline));
      this.baselines = [baseline, ...this.baselines.filter((item) => item.id !== baseline.id)];

      // 该鸟种当季未定论的记录重新比对：仅打标记，结论状态留给资料室按新均线确认；
      // 其它鸟种/季度、以及定论记录完全不动。
      const recomparedAt = baseline.approvedAt;
      const openReviews = this.reviews.filter((review) => isOpenStatus(review.status) && scope.has(review.morphId));
      if (openReviews.length) {
        await db.reviews.bulkPut(
          openReviews.map((review) => toPlain({ ...review, recomparedAt })),
        );
        this.reviews = this.reviews.map((review) =>
          isOpenStatus(review.status) && scope.has(review.morphId) ? { ...review, recomparedAt } : review,
        );
      }
      return { baseline, recompared: openReviews.length };
    },

    /** 资料室确认两边不符记录：确认采纳后转为「已修正」或「维持原值」定论 */
    async resolveMismatch(morphId: string, status: Extract<ReviewStatus, '维持原值' | '已修正'>, reviewedBy: string, note?: string, corrected?: Partial<MeasureValueSet>) {
      const existing = this.reviews.find((review) => review.morphId === morphId);
      if (!existing) return;
      const next: MeasureReview = {
        ...existing,
        status,
        note: note?.trim() || existing.note,
        corrected: corrected && Object.keys(corrected).length ? toPlain(corrected) : existing.corrected,
        reviewedBy: reviewedBy.trim() || existing.reviewedBy,
        reviewedAt: new Date().toISOString(),
      };
      await db.reviews.put(toPlain(next));
      this.upsertLocal(next);
    },

    upsertLocal(review: MeasureReview) {
      const idx = this.reviews.findIndex((item) => item.morphId === review.morphId);
      if (idx >= 0) {
        this.reviews = this.reviews.map((item) => (item.morphId === review.morphId ? review : item));
      } else {
        this.reviews = [review, ...this.reviews];
      }
    },
  },
});
