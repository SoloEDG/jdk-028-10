<script setup lang="ts">
import { computed } from "vue";
import type { CircuitDocument } from "@/shared/types";
import { useKmap } from "../model/useKmap";
import type { KmapSolutionView } from "./KmapPanel.vue";
import KmapPanel from "./KmapPanel.vue";
import KmapVerifyPanel from "./KmapVerifyPanel.vue";

const props = defineProps<{ document: CircuitDocument }>();
const emit = defineEmits<{ requestDocumentUpdate: [document: CircuitDocument] }>();

const kmap = useKmap(
  computed(() => props.document),
  (next) => emit("requestDocumentUpdate", next),
);

const solutionViews = computed<KmapSolutionView[]>(() =>
  kmap.solutions.value.map((record, index) => ({
    index,
    cost: record.solution.cost,
    andGates: record.solution.breakdown.andGates,
    orGates: record.solution.breakdown.orGates,
    notGates: record.solution.breakdown.notGates,
    locked: record.locked,
    terms: mergeForView(record.solution.terms),
  })),
);

function mergeForView(
  terms: readonly { fixed: readonly (0 | 1 | -1)[]; outputs: readonly number[] }[],
): { text: string; outputs: number[] }[] {
  const map = new Map<
    string,
    { fixed: readonly (0 | 1 | -1)[]; outputs: number[] }
  >();
  for (const term of terms) {
    const key = term.fixed.join("");
    const prior = map.get(key);
    if (prior) {
      for (const output of term.outputs)
        if (!prior.outputs.includes(output)) prior.outputs.push(output);
    } else map.set(key, { fixed: [...term.fixed], outputs: [...term.outputs] });
  }
  return [...map.values()].map((entry) => ({
    text: termText(entry.fixed),
    outputs: entry.outputs,
  }));
}

/** 用当前显示顺序写出乘积项，切换变量顺序时文字随之变化，逻辑不变。 */
function termText(fixed: readonly (0 | 1 | -1)[]): string {
  const parts: string[] = [];
  kmap.order.value.forEach((variable, position) => {
    const value = fixed[variable];
    if (value === -1) return;
    parts.push(`${kmap.variables.value[position]}${value === 0 ? "̅" : ""}`);
  });
  return parts.length ? parts.join("·") : "1";
}

function choosePreset(id: string) {
  kmap.presetId.value = id;
}

function circle(cells: number[]) {
  const error = kmap.addGroup(cells, [kmap.activeOutput.value]);
  if (error) kmap.solverNote.value = error;
}

function generate() {
  kmap.generateCircuit();
  const result = kmap.buildResult.value;
  if (result?.error) kmap.solverNote.value = result.error;
  else if (result) kmap.solverNote.value += "；电路已放到工作台，可切回“门电路工作台”查看共享项扇出";
}
</script>

<template>
  <KmapPanel
    :preset="kmap.preset.value"
    :presets="kmap.presets"
    :layout="kmap.layout.value"
    :variables="kmap.variables.value"
    :order="kmap.order.value"
    :row-vars="kmap.rowVars.value"
    :col-vars="kmap.colVars.value"
    :layer-vars="kmap.layerVars.value"
    :groups="kmap.groups.value"
    :selected-group="kmap.selectedGroup.value"
    :active-output="kmap.activeOutput.value"
    :check="kmap.studentCheck.value"
    :solving="kmap.solving.value"
    :note="kmap.solverNote.value"
    :unrestricted="kmap.unrestricted.value"
    :comparison="kmap.comparison.value"
    :independent="kmap.independent.value"
    :solutions="solutionViews"
    :solution-index="kmap.solutionIndex.value"
    :expressions="kmap.expressions.value"
    :build="kmap.buildResult.value"
    :inspected="kmap.inspected.value"
    @choose-preset="choosePreset"
    @choose-output="kmap.activeOutput.value = $event"
    @select-group="kmap.selectedGroup.value = $event"
    @toggle-lock="kmap.toggleLock"
    @remove-group="kmap.removeGroup"
    @set-outputs="kmap.setOutputs"
    @circle="circle"
    @rotate-order="kmap.rotateOrder"
    @swap-order="kmap.swapOrder"
    @solve="kmap.solveAll"
    @browse="kmap.browseSolution"
    @adopt="kmap.adoptSolution"
    @generate="generate"
    @inspect="kmap.inspect"
    @undo="kmap.undoLastGroup"
    @clear-groups="kmap.clearGroups"
  />
  <KmapVerifyPanel
    v-if="kmap.buildResult.value && !kmap.buildResult.value.error"
    class="kmap-verify-wide"
    :document="document"
    :result="kmap.buildResult.value"
  />
</template>
