import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import type { Morphometrics } from '../types/morphometrics';

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

/**
 * 环志组侧：现场量度记录。
 * 原始数值只允许新增 / 删除，不提供「改数」动作 —— 资料室复核不能改现场数值，
 * 确需更正时由资料室在复核侧另存修正值（见 reviewStore）。
 */
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
  },

  actions: {
    async hydrate() {
      this.morphs = await db.morphs.orderBy('measuredAt').reverse().toArray();
      this.hydrated = true;
    },

    /** 录入现场原始数值；同一条环志记录只允许一份现场量度 */
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
      };
      // 现场量度与资料室复核在同一事务内建账：morph 落库即产生一条「待复核」，保证两侧对得上。
      await db.transaction('rw', db.morphs, db.reviews, async () => {
        await db.morphs.put(toPlain(morph));
        await db.reviews.put(
          toPlain({
            id: `review-${morph.id}`,
            morphId: morph.id,
            status: '待复核',
            reviewedBy: '',
            reviewedAt: '',
          }),
        );
      });
      this.morphs = [morph, ...this.morphs];
      return morph;
    },

    /** 删除现场量度（同时撤掉其复核记录）；仅限环志组对自己这条现场记录操作 */
    async removeMorph(id: string) {
      await db.transaction('rw', db.morphs, db.reviews, async () => {
        await db.reviews.where('morphId').equals(id).delete();
        await db.morphs.delete(id);
      });
      this.morphs = this.morphs.filter((morph) => morph.id !== id);
    },
  },
});
