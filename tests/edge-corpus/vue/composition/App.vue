<template>
  <SummaryCard :label="title" :options="options" />
</template>

<script setup lang="ts">
import { makeRecord, updateRecord, type RecordOptions } from "./records.ts";
import SummaryCard, { cardTitle } from "./SummaryCard.vue";
import { normalizeLabel as normalize } from "./labels.ts";

const appState = makeRecord(); // @def appState @coverage appState complete
const initial = makeRecord(); // @ref makeRecord @goto makeRecord
const updated = updateRecord(initial); // @ref updateRecord @goto updateRecord
const title = normalize(updated.label); // @ref normalizeLabel @goto normalizeLabel=normalize
const options: RecordOptions = { enabled: true }; // @ref RecordOptions @goto RecordOptions
const currentState = appState; // @ref appState @goto appState
const card = SummaryCard; // @ref SummaryCard @goto SummaryCard
const labelText = cardTitle; // @ref cardTitle @goto cardTitle
const normalizedAgain = normalize(title); // @ref normalizeLabel
const finalTitle = normalizedAgain; // @def finalTitle @coverage finalTitle complete
const titleForDisplay = finalTitle; // @ref finalTitle @goto finalTitle
const functionName = "normalizeLabel"; // @not-ref normalizeLabel
// @not-ref makeRecord
/* makeRecord appears only in this comment decoy. */
// @not-ref-block updateRecord
const codeSample = `updateRecord(
  "updateRecord"
)`;
const componentName = "SummaryCard"; // @not-ref SummaryCard
</script>
