<script setup lang="ts">
/**
 * 生成电路后的逐格复核卡。
 *
 * 生成时已经用表达式和真实仿真各核对过一遍；这里对“当前画布上的电路”
 * 再做一次独立复核：只要学生改动连线，就会重新比对目标表并标出不一致。
 */
import { computed } from "vue";
import type { CircuitDocument } from "@/shared/types";
import type { BuildResult } from "../lib/circuit";
import { verifyCircuit } from "../lib/circuit";
import type { KmapPreset } from "../lib/presets";

const props = defineProps<{
  document: CircuitDocument;
  result: BuildResult;
}>();

const preset = computed<KmapPreset>(() => ({
  id: props.result.presetId,
  title: `卡诺图 · ${props.result.presetId}`,
  brief: "",
  hint: "",
  variables: props.result.variables,
  outputs: props.result.outputs.map((output, index) => ({
    id: `o${index}`,
    label: output.label,
    cells: output.cells,
  })),
}));

const liveMismatches = computed(() =>
  verifyCircuit(props.document, preset.value),
);
const livePassed = computed(() => liveMismatches.value.length === 0);

function bitsLabel(cell: number): string {
  return props.result.variables
    .map((label, index) => `${label}=${(cell >> index) & 1}`)
    .join(" ");
}

const sharedTermCount = computed(() => props.result.sharedTerms);
const totalTerms = computed(() =>
  new Set(
    props.result.expressions
      .flatMap((line) => (line.split("=")[1] ?? "").split("+"))
      .map((term) => term.trim())
      .filter((term) => term && term !== "0"),
  ).size,
);

function statusOf(outputIndex: number, cell: number): "ok" | "bad" | "dontcare" {
  const expected = props.result.outputs[outputIndex].cells[cell];
  if (expected === "X") return "dontcare";
  const mismatch = liveMismatches.value.some(
    (item) => item.output === props.result.outputs[outputIndex].label && item.cell === cell,
  );
  return mismatch ? "bad" : "ok";
}
</script>

<template>
  <section class="kmap-verify panel">
    <div class="panel-heading">
      <span>生成电路复核</span><small>GENERATED NETWORK</small>
    </div>
    <div class="verify-banner" :class="livePassed ? 'ok' : 'bad'" role="status">
      <template v-if="livePassed">
        ✓ 生成表达式与目标表逐格一致；画布信号也与目标表逐格一致（核对
        {{ result.checkedCells }} 个必须格，无关项按规则跳过）
      </template>
      <template v-else>
        ! 当前画布与目标表有 {{ liveMismatches.length }} 处不一致（生成时是一致的）；
        下方逐格对照会标出具体输入组合，修复连线后自动更新。
      </template>
    </div>
    <ul class="verify-expressions">
      <li v-for="(line, index) in result.expressions" :key="index">
        <code>{{ line }}</code>
      </li>
    </ul>
    <p class="verify-share">
      共享乘积项：<b>{{ sharedTermCount }}</b> / {{ totalTerms }} 条
      <span v-if="sharedTermCount">
        —— 同一个与门输出同时接到多个输出的或树，画布上就是同一根项线扇出。
      </span>
      <span v-else>—— 本方案没有跨输出复用的乘积项。</span>
    </p>
    <details class="verify-details">
      <summary>逐格对照目标表与仿真值</summary>
      <div class="verify-tables">
        <table
          v-for="(output, outputIndex) in result.outputs"
          :key="outputIndex"
          class="truth-table compact"
        >
          <thead>
            <tr>
              <th>输入</th>
              <th>目标 {{ output.label }}</th>
              <th>当前画布 {{ output.label }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="cell in 1 << result.variables.length" :key="cell - 1">
              <td class="bits">{{ bitsLabel(cell - 1) }}</td>
              <td>
                {{
                  result.outputs[outputIndex].cells[cell - 1] === "X"
                    ? "×"
                    : result.outputs[outputIndex].cells[cell - 1]
                }}
              </td>
              <td :class="statusOf(outputIndex, cell - 1)">
                {{
                  result.outputs[outputIndex].cells[cell - 1] === "X"
                    ? "×"
                    : liveMismatches.some(
                        (item) =>
                          item.output === output.label &&
                          item.cell === cell - 1,
                      )
                      ? "不符"
                      : "一致"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>
