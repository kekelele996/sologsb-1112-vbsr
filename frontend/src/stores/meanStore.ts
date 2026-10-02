import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { currentQuarter, type SpeciesMean } from '../types/species-mean';
import type { MeasureKey, Morphometrics } from '../types/morphometrics';
import { useMeasureStore } from './measureStore';

interface MeanState {
  means: SpeciesMean[];
  hydrated: boolean;
}

/** 鸟种量度均线（资料室按季核定） */
export const useMeanStore = defineStore('mean', {
  state: (): MeanState => ({ means: [], hydrated: false }),

  getters: {
    /** 某鸟种的全部核定均线（按季度倒序） */
    bySpecies(state) {
      return (speciesCn: string): SpeciesMean[] =>
        state.means.filter((item) => item.speciesCn === speciesCn).sort((a, b) => b.quarter.localeCompare(a.quarter));
    },
    /** 某鸟种某季度的核定均线 */
    approvedFor(state) {
      return (speciesCn: string, quarter: string): SpeciesMean | undefined =>
        state.means.find((item) => item.speciesCn === speciesCn && item.quarter === quarter);
    },
  },

  actions: {
    async hydrate() {
      this.means = await db.speciesMeans.toArray();
      this.hydrated = true;
    },

    /**
     * 资料室按季核定均线：写入本季均线，并把该鸟种未定论记录标记为「待重新比对」；
     * 已定论记录的结论与原始数值都不动。
     */
    async approveMean(speciesCn: string, means: Record<MeasureKey, number>, approvedBy: string): Promise<SpeciesMean> {
      const quarter = currentQuarter();
      const approvedAt = new Date().toISOString();

      const rings = await db.rings.toArray();
      const speciesRingIds = new Set(rings.filter((ring) => ring.speciesCn === speciesCn).map((ring) => ring.id));
      const morphs = await db.morphs.toArray();
      const basedOn = morphs.filter(
        (morph) => speciesRingIds.has(morph.ringId) && morph.review?.status === 'confirmed',
      ).length;

      const record: SpeciesMean = {
        id: uid('mean'),
        speciesCn,
        quarter,
        means,
        basedOn,
        approvedBy,
        approvedAt,
      };
      await db.speciesMeans.put(toPlain(record));

      // 核定后还没定论的重新比对；定了论的结论和原始数值都不动
      if (speciesRingIds.size > 0) {
        await db.morphs.where('ringId').anyOf(Array.from(speciesRingIds)).modify((morph: Morphometrics) => {
          if (morph.review?.status !== 'confirmed') {
            morph.review = { ...(morph.review ?? { status: 'pending' }), recompareAt: approvedAt };
          }
        });
      }

      this.means = await db.speciesMeans.toArray();
      await useMeasureStore().hydrate();
      return record;
    },
  },
});
