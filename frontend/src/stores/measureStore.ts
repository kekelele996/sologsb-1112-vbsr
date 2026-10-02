import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { hasCorrections, isConcluded, isLocked, type Morphometrics, type ReviewInfo } from '../types/morphometrics';

export interface MorphInput {
  ringId: string;
  billLength: number;
  billWidth: number;
  wingLength: number;
  tailLength: number;
  tarsusLength: number;
  weight: number;
  fatScore: number;
  measuredBy: string;
  measuredAt?: string;
}

interface MeasureState {
  morphs: Morphometrics[];
  hydrated: boolean;
}

/** 量度记录与均值偏离（偏离值在页面用 utils/stats.ts 计算，保证响应式安全） */
export const useMeasureStore = defineStore('measure', {
  state: (): MeasureState => ({ morphs: [], hydrated: false }),

  getters: {
    byRing(state) {
      return (ringId: string): Morphometrics | undefined =>
        [...state.morphs].filter((morph) => morph.ringId === ringId).sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0];
    },
    morphsOf(state) {
      return (ringId: string): Morphometrics[] => state.morphs.filter((morph) => morph.ringId === ringId);
    },
    /** 已测量个体数（去重环志记录） */
    measuredRingCount(state): number {
      return new Set(state.morphs.map((morph) => morph.ringId)).size;
    },
    /** 待复核队列（未定论：未复核 / 存疑 / 待复测） */
    reviewQueue(state): Morphometrics[] {
      return state.morphs.filter((morph) => !isConcluded(morph));
    },
    /** 未复核数（角标用） */
    pendingCount(state): number {
      return state.morphs.filter((morph) => !morph.review || morph.review.status === 'pending').length;
    },
    /** 对不上清单：存疑 / 待复测 / 有修正值（两边数值或结论对不上，等人确认） */
    mismatchList(state): Morphometrics[] {
      return state.morphs.filter((morph) => {
        const status = morph.review?.status;
        return status === 'doubtful' || status === 'remeasure' || hasCorrections(morph);
      });
    },
  },

  actions: {
    async hydrate() {
      this.morphs = await db.morphs.orderBy('measuredAt').reverse().toArray();
      this.hydrated = true;
    },

    /** 环志组录入现场原始数值（复核侧初始为未复核，原值照原样留着） */
    async addMorph(input: MorphInput): Promise<Morphometrics> {
      const morph: Morphometrics = {
        id: uid('morph'),
        ringId: input.ringId,
        billLength: Number(input.billLength) || 0,
        billWidth: Number(input.billWidth) || 0,
        wingLength: Number(input.wingLength) || 0,
        tailLength: Number(input.tailLength) || 0,
        tarsusLength: Number(input.tarsusLength) || 0,
        weight: Number(input.weight) || 0,
        fatScore: Number(input.fatScore) || 0,
        measuredBy: input.measuredBy.trim(),
        measuredAt: input.measuredAt ?? new Date().toISOString(),
        review: { status: 'pending' },
      };
      await db.morphs.put(toPlain(morph));
      this.morphs = [morph, ...this.morphs];
      return morph;
    },

    /** 现场数值更正：仅未复核记录可改；已进入复核后改值只能走修正值（另存不覆盖） */
    async updateMorph(id: string, patch: Partial<MorphInput>) {
      const current = this.morphs.find((morph) => morph.id === id);
      if (!current) return;
      if (isLocked(current)) return;
      const next: Morphometrics = { ...current, ...patch };
      await db.morphs.put(toPlain(next));
      this.morphs = this.morphs.map((morph) => (morph.id === id ? next : morph));
    },

    async removeMorph(id: string) {
      await db.morphs.delete(id);
      this.morphs = this.morphs.filter((morph) => morph.id !== id);
    },

    /**
     * 资料室提交复核结论（结论 / 存疑 / 复测要求 / 修正值写在复核侧，不动现场原始数值）。
     * opts.simulateFailure 用于演示提交失败：失败后状态回滚，页面可重试。
     */
    async submitReview(id: string, review: ReviewInfo, opts?: { simulateFailure?: boolean }): Promise<void> {
      if (opts?.simulateFailure) {
        await new Promise((_, reject) => {
          setTimeout(() => reject(new Error('模拟提交失败：网络异常，请重试')), 700);
        });
      }
      const current = this.morphs.find((morph) => morph.id === id);
      if (!current) return;
      const next: Morphometrics = { ...current, review: { ...review } };
      await db.morphs.put(toPlain(next));
      this.morphs = this.morphs.map((morph) => (morph.id === id ? next : morph));
    },
  },
});
